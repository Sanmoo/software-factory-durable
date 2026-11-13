// TEST ONLY loader-boundary double. VFS mode uses the audited actual Host JS
// provider/RPC only; VM remains a double. No Guest/FUSE/kernel/durability proof.
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, open, readFile, readlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import Module, { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { auditedVfsManifest } from './fixtures/audited-vfs-manifest.js';
import { observeSdkGlobals } from './audited-vfs-observer.js';
import { verifyAuditedVfsSources } from './audited-vfs-guard.js';
import { guardFixtureNetwork } from './adapter-fixture-network-guard.js';
import { promisify } from 'node:util';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { RealFSProvider as RealProviderType } from '@earendil-works/gondolin';

const [root, environment, boot] = process.argv.slice(2);
if (!root || !environment || !boot) throw new Error('FIXTURE_ARGUMENTS_REQUIRED');
// Guard before application imports. Default remains SDK-deny-all. Only these
// two exact entries and the pinned parent/specifier graph may evaluate in VFS mode.
const actualVfs = process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE === 'vfs-confinement';
const networkGuard = guardFixtureNetwork(root, false, actualVfs ? 'audited-owned-vfs' : 'deny-all');
const sdkObserver = actualVfs ? observeSdkGlobals() : undefined;
let ActualProvider: (new (root: string) => RealProviderType) | undefined;
type Rpc = {
  handleRequest(message: { v: 1; t: 'fs_request'; id: number; p: { op: string; req: Record<string, unknown> } }):
    Promise<{ p: { err: number; res?: Record<string, unknown> } }>;
  close(): Promise<void>;
  inoToPaths: Map<number, Set<string>>;
};
let ActualRpc: (new (provider: RealProviderType) => Rpc) | undefined;
if (actualVfs) {
  const stat = fs.lstatSync(root);
  assert.ok(stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o7777) === 0o700);
  assert.equal(fs.realpathSync(root), root);
  assert.equal(typeof Module.registerHooks, 'function', 'PUBLIC_REGISTER_HOOKS_REQUIRED_BEFORE_SDK');
  // Negative guard cases precede the positive graph, never evaluate root/VM/hooks.
  for (const path of ['dist/src/index.js', 'dist/src/vm/core.js', 'dist/src/vfs/node/vendored-node-vfs/lib/internal/vfs/module_hooks.js', 'dist/src/vfs/unlisted.js']) {
    // eslint-disable-next-line no-restricted-syntax -- Test-only pre-evaluation denial of exact forbidden SDK targets.
    await assert.rejects(import(pathToFileURL(auditedVfsManifest.root + '/' + path).href), /SDK_EVALUATION_FORBIDDEN/);
  }
  assert.deepEqual(networkGuard.sdk!.loaded, []);
  // eslint-disable-next-line no-restricted-syntax -- Test-only fixed audited canonical entry under closed hooks.
  const providerModule = await import(pathToFileURL(auditedVfsManifest.root + '/dist/src/vfs/node/vendored-node-vfs/lib/internal/vfs/providers/real.js').href);
  // eslint-disable-next-line no-restricted-syntax -- Test-only fixed audited canonical entry under closed hooks.
  const rpcModule = await import(pathToFileURL(auditedVfsManifest.root + '/dist/src/vfs/rpc-service.js').href);
  ActualProvider = providerModule.RealFSProvider;
  ActualRpc = rpcModule.FsRpcService;
  assert.equal(typeof ActualProvider, 'function'); assert.equal(typeof ActualRpc, 'function');
  assert.equal(ActualProvider!.name, 'RealFSProvider'); assert.equal(ActualRpc!.name, 'FsRpcService');
  // Cached CJS exports do not grant a new external-parent/absolute-path edge.
  // eslint-disable-next-line no-restricted-syntax -- Public loader used only for pre-dispatch negative cached-CJS checks against already approved code.
  const fromFixture = Module.createRequire(import.meta.url);
  let cachedCjsDenied = 0;
  for (const name of ['providers/real', 'provider', 'errors']) {
    assert.throws(() => fromFixture(auditedVfsManifest.root + '/dist/src/vfs/node/vendored-node-vfs/lib/internal/vfs/' + name + '.js'), /SDK_EVALUATION_FORBIDDEN/);
    cachedCjsDenied++;
  }
  sdkObserver!.assertUnchanged();
  assert.deepEqual([...new Set(networkGuard.sdk!.loaded)].sort(), auditedVfsManifest.files.filter(f => f.kind === 'approved-eager-module').map(f => f.path).sort());
  fs.writeFileSync(join(root, 'sdk-source-graph.json'), JSON.stringify({ aggregate: auditedVfsManifest.aggregate,
    loaded: networkGuard.sdk!.loaded, sdkHookCalls: sdkObserver!.calls, ownGuardRegistrations: 1, cachedCjsDenied,
    provider: ActualProvider!.name, rpc: ActualRpc!.name, vm: 'EXPLICIT_DOUBLE' }), { mode: 0o600 });
  sdkObserver!.restore();
}
let operationsObserver: ReturnType<typeof observeSdkGlobals> | undefined;
const hostBoot = '11111111-2222-4333-8444-555555555555';
const namespaces = { cgroup: 'cgroup:[12345]', mnt: 'mnt:[12345]' };
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
if (actualVfs) {
  for (const name of ['workspace', 'artifacts']) await mkdir(join(directory, name), { mode: 0o700 });
  for (const zone of ['home', 'control', 'git-cache', 'other-work']) {
    await mkdir(join(root, 'protected', zone), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'protected', zone, 'secret'), 'PRIVATE_TOKEN_CANARY', { mode: 0o600 });
  }
}
await json(join(directory, 'owner.json'), { version: 1, workId, environment, configuration,
  guestAssets: { directory: assets, manifestSha256: sha(manifest) } });
await json(join(directory, 'ready.json'), { environment });
await json(join(directory, 'current.json'), { version: 1, environment, boot });
await json(join(path, 'identity.json'), { version: 1, environment, boot, unit, configuration,
  hostBoot });
const tag = Buffer.from(boot.slice(5).replaceAll('-', ''), 'hex').toString('base64url');
const runtime = join(root, 'r', tag);
await mkdir(runtime, { recursive: true, mode: 0o700 });
for (const name of ['t', 'c', 's']) await mkdir(join(runtime, name), { mode: 0o700 });
await json(join(runtime, 'owner.json'), { version: 1, environment, boot });
process.env.TMPDIR = join(runtime, 't');
process.env.XDG_CACHE_HOME = join(runtime, 'c');
process.env.GONDOLIN_SESSIONS_DIR = join(runtime, 's');
// No PATH executable convention: only this exact read-only manager argv is doubled.
const invocation = 'a'.repeat(32);
const managerArgs = ['--user', 'show', unit, '--property=LoadState,ActiveState,SubState,InvocationID,ControlGroup,MainPID,Result'];
const manager = (command: string, args: string[]) => {
  assert.equal(command, 'systemctl'); assert.deepEqual(args, managerArgs);
  return { stdout: `LoadState=loaded\nActiveState=active\nSubState=running\nInvocationID=${invocation}\nControlGroup=${group}\nMainPID=${process.pid}\nResult=success\n`, stderr: '' };
};
const execFileDouble = Object.assign(() => { throw new Error('CALLBACK_EXEC_FORBIDDEN'); }, {
  [promisify.custom]: async (command: string, args: string[]) => manager(command, args),
});
const originalExecFile = cp.execFile;
cp.execFile = execFileDouble as unknown as typeof cp.execFile;
const deniedCommands = ['exec', 'execSync', 'execFileSync', 'spawnSync', 'fork'] as const;
const originalCommands = deniedCommands.map(operation => cp[operation]);
for (const operation of deniedCommands) {
  Reflect.set(cp, operation, () => { throw new Error('OS_COMMAND_FORBIDDEN'); });
}
mock.method(process, 'kill', () => { throw new Error('HOST_SIGNAL_FORBIDDEN'); });
const nativeEdit = process.env.TASK114_EDIT;
let editSource = Buffer.from(nativeEdit === 'empty' ? '' : nativeEdit === 'secret' ? 'old synthetic-secret' : '\ufeffold\r\nsafe █\r\n');
let editCommits = 0;
let editChild: cp.ChildProcess | undefined;
const nativeBuilder = process.env.TASK83_NATIVE_BUILDER === '1';
const nativeBash = process.env.TASK85_NATIVE_BASH === '1';
const nativeCopy = process.env.TASK145_COPY;
const nativeCopyRead = process.env.TASK149_READ === '1';
let bashFinished = false;
// VM double only; these virtual files/sentinel do not establish kernel FD safety.
const virtualBuilderFiles = new Map<string, string>([
  ['/workspace/nested/new.txt', 'previous longer regular-file content'], ['/outside/sentinel', 'untouched'],
]);
const actualSpawn = cp.spawn;
cp.spawn = ((command: string, args: string[], options: cp.SpawnOptions) => {
  const worker = new URL('../../src/entrypoints/worker.js', import.meta.url).pathname;
  if (process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE !== 'normal-worker' || command !== process.execPath ||
      args.length !== 1 || args[0] !== worker || options.detached !== false ||
      JSON.stringify(options.stdio) !== JSON.stringify(['ignore', 'ignore', 'ignore', 'ipc'])) throw new Error('REAL_PROCESS_SPAWN_FORBIDDEN_IN_FIXTURE');
  assert.equal(process.execPath, '/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node');
  assert.deepEqual(Object.keys(options).sort(), ['detached', 'env', 'stdio']);
  assert.deepEqual(Object.keys(options.env!).sort(), ['LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
  assert.equal(options.env!.PATH, '');
  assert.equal(options.env!.LANG, 'C'); assert.equal(options.env!.LC_ALL, 'C');
  assert.equal(options.env!.NODE_DISABLE_COMPILE_CACHE, '1');
  for (const name of ['TMPDIR', 'XDG_CACHE_HOME']) assert.ok(options.env![name]?.startsWith(runtime + '/w-'));
  audit('worker-spawn');
  let preload = new URL('./fixtures/adapter-read-provider-preload.js', import.meta.url);
  if (nativeBuilder) preload = new URL('./fixtures/adapter-write-provider-preload.js', import.meta.url);
  if (nativeBash) preload = new URL('./fixtures/adapter-bash-provider-preload.js', import.meta.url);
  if (nativeEdit) preload = new URL('./fixtures/adapter-edit-provider-preload.js', import.meta.url);
  if (nativeCopy) preload = new URL('./fixtures/adapter-bash-copy-provider-preload.js', import.meta.url);
  if (nativeCopyRead) preload = new URL('./fixtures/adapter-copy-read-provider-preload.js', import.meta.url);
  const child = actualSpawn(command, ['--import', preload.pathname, ...args], options);
  if (nativeEdit) editChild = child;
  child.on('message', message => {
    audit('worker-message:' + JSON.stringify(message));
    if (message && typeof message === 'object' && 'kind' in message && message.kind === 'provider-request') {
      const work = join(root!, workId, 'evidence');
      assert.ok(fs.readdirSync(work).some(id => {
        try {
          const stored = JSON.parse(fs.readFileSync(join(work, id, 'output'), 'utf8'));
          return stored.event?.kind === 'worker-start' && fs.existsSync(join(work, id, 'complete.json'));
        } catch { return false; }
      }), 'protected start must be complete before any provider request');
    }
  });
  child.on('exit', code => { audit('worker-exit:' + code); });
  return child;
}) as typeof cp.spawn;
const originalRead = fs.promises.readFile;
mock.method(fs.promises, 'readFile', (async (...args: Parameters<typeof originalRead>) => {
  const target = String(args[0]);
  if (target === '/proc/self/cgroup' || target === `/proc/${process.pid}/cgroup`) return `0::${group}\n`;
  if (target === '/proc/sys/kernel/random/boot_id') return hostBoot + '\n';
  if (target === '/sys/fs/cgroup/cgroup.controllers') return 'cpu memory pids\n';
  if (target === '/proc/self/mountinfo') return '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n';
  if (target === `/proc/${process.pid}/stat`) return `${process.pid} (fixture) ` + [...Array(19).fill('0'), '12345'].join(' ');
  if (target.startsWith('/proc/') || target.startsWith('/sys/')) throw new Error('UNLISTED_HOST_READ');
  return originalRead(...args);
}) as typeof originalRead);
const originalLink = fs.promises.readlink;
mock.method(fs.promises, 'readlink', (async (...args: Parameters<typeof originalLink>) => {
  const target = String(args[0]);
  if (target === '/proc/self/ns/cgroup') return namespaces.cgroup;
  if (target === '/proc/self/ns/mnt') return namespaces.mnt;
  if (/^\/proc\/self\/fd\/[0-9]+$/.test(target)) {
    const result = await originalLink(...args);
    assert.ok(String(result) === root || String(result).startsWith(root + '/'), 'only owned fixture descriptors');
    return result;
  }
  if (target.startsWith('/proc/') || target.startsWith('/sys/')) throw new Error('UNLISTED_HOST_LINK');
  return originalLink(...args);
}) as typeof originalLink);
const originalLstat = fs.promises.lstat;
mock.method(fs.promises, 'lstat', (async (...args: Parameters<typeof originalLstat>) => {
  const target = String(args[0]);
  if (target === '/sys/fs/cgroup') return { isDirectory: () => true, isSymbolicLink: () => false };
  if (target.startsWith('/proc/') || target.startsWith('/sys/')) throw new Error('UNLISTED_HOST_STAT');
  return Reflect.apply(originalLstat, fs.promises, args);
}) as typeof originalLstat);
mock.method(fs.promises, 'statfs', (async (target: unknown) => {
  assert.equal(target, '/sys/fs/cgroup'); return { type: 0x63677270 };
}) as typeof fs.promises.statfs);
syncBuiltinESMExports();

const audit = (event: string) => fs.appendFileSync(join(root, 'audit'), `${event}\n`);
const originalTermListeners = new Set(process.listeners('SIGTERM'));
type Logger = ((component: string, message: string) => void) | null;
let logger: Logger = null;
let lateLogger: Logger = null;
let execCalls = 0;
const mode = process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_FIXTURE'); };
const sdkDouble = {
  VM: { async create(options: { debugLog: Logger; sandbox: { console: string; debug: readonly string[] | boolean };
    vfs: { mounts: Record<string, RealProviderType> } }) {
    if (mode === 'owner-registration' || nativeBash) audit('vm-create');
    if (actualVfs) await actualOwnedVfsProbe(options.vfs.mounts);
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
      if (mode === 'normal-worker' || mode === 'owner-registration' || mode === 'markers-success' || mode === 'vfs-confinement' || mode?.startsWith('shutdown-')) return;
      const listeners = process.listeners('SIGTERM').filter(listener => !originalTermListeners.has(listener));
      if (listeners.length !== 1) throw new Error('EXPECTED_ONE_ADAPTER_STOP_LISTENER');
      // Invoke only the newly registered adapter callback; no OS signal or broad emit.
      if (process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE !== 'without-stop') listeners[0]!('SIGTERM');
      throw Object.assign(new Error('PRIVATE_TOKEN_CANARY'), {
        code: process.env.ADAPTER_DIAGNOSTIC_FIXTURE_MODE === 'unknown-error' ? 'PRIVATE_CODE_CANARY' : 'vm_start_timeout',
      });
    },
    async close() {
      if (actualVfs) {
        operationsObserver!.assertUnchanged();
        assert.equal(verifyAuditedVfsSources(), auditedVfsManifest.aggregate);
        operationsObserver!.restore(); operationsObserver = undefined;
      }
      audit('close');
    },
    id: '77777777-2222-4333-8444-555555555555',
    getHostPid() { return process.pid; }, // External VM double, never a real VMM.
    exec(argv: string[], options: { signal: AbortSignal; stdout?: string; stderr?: string; env?: Record<string, string>; cwd?: string; stdin?: string | AsyncIterable<Buffer>; stdinCapacity?: { maxChunkBytes: number } }) {
      if (nativeCopy && argv[2] === '/usr/bin/python3') {
        // Receipt DOUBLE consumes the whole iterable, never runs helper SOURCE.
        // No kernel FD/backpressure/physical-durability proof is claimed.
        assert.ok(bashFinished); audit('copy-output');
        assert.deepEqual(argv.slice(0, 6), ['/usr/bin/env', '-i', '/usr/bin/python3', '-I', '-S', '-c']);
        assert.equal(argv[7], 'stream'); assert.match(argv[8]!, /^\/artifacts\/factory-output-[0-9a-f-]{36}\.txt$/);
        assert.deepEqual(options.stdinCapacity, { maxChunkBytes: 65536 });
        assert.deepEqual(options.env, {}); assert.equal(options.cwd, '/');
        return { async *output() {
          assert.ok(options.stdin && typeof options.stdin !== 'string');
          const chunks: Buffer[] = [];
          for await (const chunk of options.stdin) { assert.ok(chunk.length <= 65536); chunks.push(Buffer.from(chunk)); }
          const bytes = Buffer.concat(chunks);
          fs.writeFileSync(join(root!, 'copy-double-bytes'), bytes, { mode: 0o600 });
          if (nativeCopyRead) virtualBuilderFiles.set(argv[8]!, bytes.toString());
          yield { stream: 'stdout', data: Buffer.from(JSON.stringify({ bytes: bytes.length,
            sha256: nativeCopy === 'fail' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') })) };
        }, result: Promise.resolve({ exitCode: 0 }) };
      }
      if (nativeCopyRead && argv[0] === '/usr/bin/python3' && argv.length === 8) {
        audit('read-attempt'); // BEFORE ALL assertions; owner catches errors.
        assert.deepEqual(argv.slice(0, 4), ['/usr/bin/python3', '-I', '-S', '-c']);
        const selected = JSON.parse(argv[7]!) as string[];
        assert.ok(selected.includes(argv[5]!));
        const text = virtualBuilderFiles.get(argv[5]!); assert.ok(text);
        audit('read-validated');
        return { async *output() { const bytes = Buffer.from(text); for (let i = 0; i < bytes.length; i += 65536) yield { stream: 'stdout', data: bytes.subarray(i, i + 65536) }; }, result: Promise.resolve({ exitCode: 0 }) };
      }
      if (nativeEdit && argv[0] === '/usr/bin/python3') {
        assert.ok(typeof options.stdin === 'string');
        assert.deepEqual(argv.slice(0, 4), ['/usr/bin/python3', '-I', '-S', '-c']);
        const operation = argv.length === 6 ? 'capture' : argv[5]!;
        audit('edit-' + operation);
        if (operation === 'capture') {
          assert.equal(argv[5], '/workspace/source');
          const captured = Buffer.from(editSource);
          if (nativeEdit === 'cancel' || nativeEdit === 'eof') {
            const cancelled = new Promise<void>(resolve => {
              if (options.signal.aborted) resolve();
              else options.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            if (nativeEdit === 'cancel') editChild!.send({ kind: 'abort' });
            else editChild!.disconnect();
            return { async *output() { await cancelled; }, result: cancelled.then(() => ({ exitCode: 1 })) };
          }
          return { async *output() { yield { stream: 'stdout', data: captured }; }, result: Promise.resolve({ exitCode: 0 }) };
        }
        assert.deepEqual(options.env, {}); assert.equal(options.cwd, '/');
        const evidence = join(root!, workId, 'evidence');
        const events = fs.readdirSync(evidence).flatMap(id => {
          if (!fs.existsSync(join(evidence, id, 'complete.json'))) return [];
          try { const event = JSON.parse(fs.readFileSync(join(evidence, id, 'output'), 'utf8')).event; return event ? [event] : []; }
          catch { return []; } // Captured source is text, not an event envelope.
        });
        assert.ok(events.some(e => e.kind === 'worker-start'));
        assert.ok(events.some(e => e.kind === 'mutation-intent' && e.operation === operation));
        let exitCode = 0;
        if (operation === 'commit') {
          assert.equal(argv[6], '/workspace/source');
          assert.equal(Number(argv[7]), editSource.length);
          assert.equal(argv[8], createHash('sha256').update(editSource).digest('hex'));
          editCommits++;
          if (nativeEdit === 'mismatch' && editCommits === 1) exitCode = 42;
          else {
            editSource = Buffer.from(options.stdin!);
            assert.equal(editSource.toString(), '\ufeffnew\r\nsafe █\r\n');
            if (nativeEdit === 'uncertain') exitCode = 1;
          }
          fs.writeFileSync(join(root!, 'edit-result'), editSource);
        } else assert.ok(['mkdir', 'create'].includes(operation));
        return { async *output() { yield { stream: 'stdout', data: Buffer.from('synthetic-secret synthetic-key') }; }, result: Promise.resolve({ exitCode }) };
      }
      if (nativeBash && argv[0] === '/usr/bin/env') {
        audit('bash');
        assert.deepEqual(argv, ['/usr/bin/env', '-i', '/bin/bash', '-c', "printf 'syn''thetic-se''cret'; printf 'tail π' >&2"]);
        assert.deepEqual(options.env, {}); assert.equal(options.cwd, '/workspace');
        assert.equal(options.stdout, 'pipe'); assert.equal(options.stderr, 'pipe');
        const source = Buffer.from('head π synthetic-secret synthetic-key segredo-🔒-ação\n' + 'filtered output\n'.repeat(80000) + 'tail π');
        return { async *output() {
          for (let offset = 0; offset < source.length; offset += 8191) yield {
            stream: offset % 2 ? 'stderr' : 'stdout', data: source.subarray(offset, offset + 8191),
          };
          if (nativeCopy) { bashFinished = true; audit('bash-complete'); }
        }, result: Promise.resolve({ exitCode: 0 }) };
      }
      if (nativeBuilder && argv[0] === '/usr/bin/python3') {
        if (nativeCopy) audit('write-attempt');
        assert.ok(typeof options.stdin === 'string');
        assert.deepEqual(argv.slice(0, 4), ['/usr/bin/python3', '-I', '-S', '-c']);
        assert.equal(argv.length, 7); assert.deepEqual(options.env, {}); assert.equal(options.cwd, '/');
        assert.doesNotMatch(JSON.stringify(argv), /synthetic-secret|synthetic-key/);
        const operation = argv[5]!; const target = argv[6]!;
        assert.equal(target, operation === 'mkdir' ? '/workspace/nested' : '/workspace/nested/new.txt');
        audit('write-' + operation);
        const evidence = join(root!, workId, 'evidence');
        const events = fs.readdirSync(evidence).flatMap(id => {
          if (!fs.existsSync(join(evidence, id, 'complete.json'))) return [];
          return [JSON.parse(fs.readFileSync(join(evidence, id, 'output'), 'utf8')).event];
        });
        assert.ok(events.some(event => event.kind === 'worker-start'), 'durable child receipt before write');
        assert.ok(events.some(event => event.kind === 'mutation-intent' && event.operation === operation), 'intent before effect');
        if (operation === 'create') {
          assert.equal(virtualBuilderFiles.has(target), true, 'public native call overwrites virtual existing regular file');
          audit('write-overwrite');
          virtualBuilderFiles.set(target, options.stdin!);
          assert.equal(virtualBuilderFiles.get('/outside/sentinel'), 'untouched');
          assert.ok(options.stdin === 'hello π\n' || options.stdin === '');
        } else { assert.equal(operation, 'mkdir'); assert.equal(options.stdin, ''); }
        return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) };
      }
      if ((mode === 'normal-worker' || mode === 'owner-registration') && argv[0] === '/usr/bin/python3') {
        audit('read');
        if (mode === 'normal-worker') {
          assert.deepEqual(argv.slice(0, 4), ['/usr/bin/python3', '-I', '-S', '-c']);
          assert.equal(argv.length, 8); assert.equal(argv[5], '/workspace/source.txt');
          const text = 'prefix\n'.repeat(5000) + 'synthetic-secret synthetic-key\ntarget\nlast';
          return { async *output() { for (let i = 0; i < text.length; i += 11) yield { stream: 'stdout', data: Buffer.from(text.slice(i, i + 11)) }; }, result: Promise.resolve({ exitCode: 0 }) };
        }
        return { async *output() { yield { stream: 'stdout', data: Buffer.from('owner-shared-VM') }; }, result: Promise.resolve({ exitCode: 0 }) };
      }
      return (async () => {
      if (options.stdout !== 'ignore' || options.stderr !== 'ignore') throw new Error('UNUSED_GUEST_OUTPUT_MUST_BE_IGNORED');
      if (mode === 'normal-worker' || mode === 'owner-registration') { audit(++execCalls === 1 ? 'profile-ready' : 'guest-finalize'); return { exitCode: 0 }; }
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
      if (mode !== 'markers-success' && mode !== 'vfs-confinement') throw new Error('GUEST_EXEC_MUST_NOT_RUN');
      if (++execCalls === 1) {
        if (mode === 'vfs-confinement') {
          fs.writeFileSync(join(root, 'guest-storage-command'), argv[2]!);
          for (const required of ['/root', '/tmp', '/var/tmp', '/var/cache', '/var/log', '/var/cache/apk', '/workspace', '/artifacts']) {
            assert.ok(argv[2]!.includes(required), `readiness must check approved persistent path ${required}`);
          }
          assert.ok(argv[2]!.includes('.factory-profile/storage-v1'));
          assert.ok(argv[2]!.includes('set -C'), 'first-boot stamp must not overwrite an existing file');
          assert.ok(argv[2]!.includes('head -c 160'), 'guest marker input is bounded before parsing');
          assert.ok(argv[2]!.includes('ln -s') && argv[2]!.includes('mv '), 'guest must exercise actual alias/rename routing');
          assert.ok(argv[2]!.includes(boot) && argv[2]!.includes(environment));
        }
        audit('guest-exec');
        lateLogger?.('qemu', 'stdout: [init] starting sandboxd');
        const listeners = process.listeners('SIGTERM').filter(listener => !originalTermListeners.has(listener));
        if (listeners.length !== 1) throw new Error('EXPECTED_ONE_ADAPTER_STOP_LISTENER');
        listeners[0]!('SIGTERM'); // Only the new callback, never an OS signal.
      }
      return { exitCode: 0 };
      })();
    },
  }; } },
  RealFSProvider: ActualProvider ?? class {
    async lstat() { throw new Error('UNEXPECTED_FILESYSTEM_ACCESS'); }
    lstatSync() { throw new Error('UNEXPECTED_FILESYSTEM_ACCESS'); }
    async readlink() { throw new Error('UNEXPECTED_FILESYSTEM_ACCESS'); }
    readlinkSync() { throw new Error('UNEXPECTED_FILESYSTEM_ACCESS'); }
    async realpath() { throw new Error('UNEXPECTED_FILESYSTEM_ACCESS'); }
    realpathSync() { throw new Error('UNEXPECTED_FILESYSTEM_ACCESS'); }
  },
};
mock.module(new URL('../../src/sandbox/gondolin-sdk-runtime.js', import.meta.url).href, {
  namedExports: { loadDevelopmentGondolinSdk: async () => sdkDouble },
});

process.once('exit', () => {
  cp.spawn = actualSpawn;
  cp.execFile = originalExecFile;
  deniedCommands.forEach((operation, index) => Reflect.set(cp, operation, originalCommands[index]));
  globalThis.fetch = originalFetch;
  mock.restoreAll();
  syncBuiltinESMExports();
});

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
  if (nativeEdit === 'persist' && String(args[0]).includes('"kind":"mutation-result"')) {
    audit('edit-result-evidence-failed'); throw new Error('INJECTED_EDIT_RESULT_FAILURE');
  }
  if ((mode === 'normal-worker' || mode === 'owner-registration' || mode?.startsWith('shutdown-')) && target === join(path, 'operational.json')) operationalPublishing = true;
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
      if (mode === 'normal-worker' && nativeEdit) {
        void import('../entrypoints/normal-edit.fixture.js').then(async ({ normalEdit }) => {
          await json(join(root!, 'normal-worker-result.json'), await normalEdit(root!, { workId, environmentRef: environment!, bootRef: boot! }));
          audit('normal-edit-passed');
        }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => listeners[0]!('SIGTERM'));
        return;
      }
      if (mode === 'normal-worker' && nativeCopyRead) {
        void import('../entrypoints/normal-copy-read.fixture.js').then(async ({ normalCopyRead }) => {
          await json(join(root!, 'normal-worker-result.json'), await normalCopyRead(root!, { workId, environmentRef: environment!, bootRef: boot! }));
          audit('normal-copy-read-passed');
        }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => listeners[0]!('SIGTERM'));
        return;
      }
      if (mode === 'normal-worker' && nativeCopy) {
        void import('../entrypoints/normal-bash-copy.fixture.js').then(async ({ normalBashCopy }) => {
          await json(join(root!, 'normal-worker-result.json'), await normalBashCopy(root!, { workId, environmentRef: environment!, bootRef: boot! }));
          audit('normal-bash-copy-passed');
        }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => listeners[0]!('SIGTERM'));
        return;
      }
      if (mode === 'normal-worker' && nativeBash) {
        void import('../entrypoints/normal-bash.fixture.js').then(async ({ normalBash }) => {
          const result = await normalBash(root!, { workId, environmentRef: environment!, bootRef: boot! });
          await json(join(root!, 'normal-worker-result.json'), result); audit('normal-bash-passed');
        }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => listeners[0]!('SIGTERM'));
        return;
      }
      if (mode === 'normal-worker' && nativeBuilder) {
        void import('../entrypoints/normal-builder.fixture.js').then(async ({ normalBuilder }) => {
          const result = await normalBuilder(root!, { workId, environmentRef: environment!, bootRef: boot! });
          await json(join(root!, 'normal-worker-result.json'), result); audit('normal-builder-passed');
        }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => listeners[0]!('SIGTERM'));
        return;
      }
      if (mode === 'normal-worker') {
        void import('../entrypoints/normal-worker.fixture.js').then(async ({ normalWorker }) => {
          const result = await normalWorker(root!, { workId, environmentRef: environment!, bootRef: boot! });
          await json(join(root!, 'normal-worker-result.json'), result);
          audit('normal-worker-passed');
        }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => listeners[0]!('SIGTERM'));
        return;
      }
      if (mode === 'owner-registration') {
        void registrationProbe().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => listeners[0]!('SIGTERM'));
        return;
      }
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

async function actualOwnedVfsProbe(mounts: Record<string, RealProviderType>) {
  audit('vfs-probe');
  operationsObserver!.assertUnchanged();
  const summaries: { mount: string; requests: number; denied: number }[] = [];
  for (const mount of ['/workspace', '/artifacts']) {
    const provider = mounts[mount]!;
    assert.ok(provider instanceof ActualProvider!);
    const canonical = fs.realpathSync(join(directory, mount.slice(1)));
    assert.equal(provider.rootPath, canonical, 'actual constructor must not use realpath fallback');
    assert.equal(Object.getPrototypeOf(provider).constructor, ActualProvider);
    const bytes = Buffer.from('owned actual VFS π\n');
    let handle = await provider.open('/owned.txt', 'wx+', 0o600);
    try { assert.equal((await handle.write(bytes, 0, bytes.length, 0)).bytesWritten, bytes.length); }
    finally { await handle.close(); }
    handle = await provider.open('/owned.txt', 'r');
    try {
      const read = Buffer.alloc(bytes.length);
      assert.equal((await handle.read(read, 0, read.length, 0)).bytesRead, bytes.length);
      assert.deepEqual(read, bytes);
    } finally { await handle.close(); }
    fs.symlinkSync('owned.txt', join(canonical, 'inside-link'));
    assert.ok((await provider.lstat('/inside-link')).isSymbolicLink());
    assert.equal(await provider.readlink('/inside-link'), 'owned.txt');
    handle = await provider.open('/inside-link', 'r');
    try { assert.deepEqual(await handle.readFile(), bytes); } finally { await handle.close(); }
    // Every symlink target is within THIS new private fixture. These canaries
    // are outside the provider mount, not outside our host authority.
    fs.symlinkSync(join(root!, 'protected', 'home'), join(canonical, 'ancestor'));
    let denied = 0;
    for (const operation of [
      () => provider.lstat('/ancestor/secret'), () => provider.readlink('/ancestor/secret'),
      () => provider.open('/ancestor/secret', 'r'), () => provider.open('../escape', 'w'),
      () => provider.rename('/owned.txt', '/ancestor/renamed'), () => provider.unlink('/ancestor/secret'),
    ]) { await assert.rejects(operation(), { code: 'ENOENT' }); denied++; }
    assert.throws(() => provider.lstatSync('/ancestor/secret'), { code: 'ENOENT' }); denied++;
    assert.throws(() => provider.readlinkSync('/ancestor/secret'), { code: 'ENOENT' }); denied++;
    const rpc = new ActualRpc!(provider);
    assert.equal(Object.getPrototypeOf(rpc).constructor, ActualRpc);
    let requests = 0;
    const request = async (op: string, req: Record<string, unknown>, error = 0) => {
      const response = await rpc.handleRequest({ v: 1, t: 'fs_request', id: ++requests, p: { op, req } });
      assert.equal(response.p.err, error, `${mount} actual RPC ${op}`);
      if (error) denied++;
      return response.p.res!;
    };
    try {
      const lookup = await request('lookup', { parent_ino: 1, name: 'owned.txt' });
      const ino = (lookup.entry as { ino: number }).ino;
      const opened = await request('open', { ino, flags: 2 });
      const fh = opened.fh;
      const data = await request('read', { fh, offset: 0, size: bytes.length });
      assert.deepEqual(data.data, bytes);
      assert.equal((await request('write', { fh, offset: 0, data: bytes })).size, bytes.length);
      await request('release', { fh });
      await request('lookup', { parent_ino: 1, name: '../secret' }, 22);
      // Forge caller inode metadata: wrapper must reject ancestor traversal,
      // including the lexical-only raw lstat/readlink weakness, without using it.
      rpc.inoToPaths.set(900, new Set(['/ancestor']));
      rpc.inoToPaths.set(901, new Set(['/ancestor/secret']));
      await request('lookup', { parent_ino: 900, name: 'secret' }, 2);
      await request('getattr', { ino: 901 }, 2);
      await request('readlink', { ino: 901 }, 2);
      await request('open', { ino: 901, flags: 0 }, 2);
      await request('rename', { old_parent_ino: 1, old_name: 'owned.txt', new_parent_ino: 900, new_name: 'renamed' }, 2);
      await request('unlink', { parent_ino: 900, name: 'secret' }, 2);
    } finally { await rpc.close(); }
    assert.deepEqual(fs.readFileSync(join(canonical, 'owned.txt')), bytes);
    summaries.push({ mount, requests, denied });
  }
  operationsObserver!.assertUnchanged();
  fs.writeFileSync(join(root!, 'vfs-observation.json'), JSON.stringify({ summaries, sdkHookCalls: operationsObserver!.calls,
    sourceHashAfter: verifyAuditedVfsSources(), native: ['RealFSProvider', 'FsRpcService'], doubled: ['VM', 'manager', 'proc', 'cgroup', 'guest commands'] }), { mode: 0o600 });
  audit('vfs-confined');
}

async function registrationProbe() {
  if (!root || !environment || !boot) throw new Error('FIXTURE_ARGUMENTS_REQUIRED');
  const { connect, protocolVersion } = await import('../../src/protocol/index.js');
  const { readdir } = await import('node:fs/promises');
  const sandbox = registrationSandbox!;
  // Incomplete launch payloads remain closed even on the normal boot endpoint.
  // The normal-worker mode separately exercises the full trusted projection.
  const launcher = await connect(join(runtime, 'owner'), 'local-operator');
  const launches = launcher.messages[Symbol.asyncIterator]();
  const binding = { workId, environmentRef: environment, bootRef: boot, invocationId: 'planned-review', role: 'standards' };
  for (const [id, payload, code] of [
    ['closed', binding, 'WORKER_LAUNCH_INVALID'],
    ['mismatch', { ...binding, workId: 'other-work' }, 'WORKER_LAUNCH_INVALID'],
    ['secret', { ...binding, apiKey: 'SYNTHETIC_SECRET_MUST_NOT_BE_ACCEPTED' }, 'WORKER_LAUNCH_INVALID'],
  ] as const) {
    await launcher.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: id, reply_to: null,
      kind: 'launch-worker', payload });
    const result = await launches.next();
    assert.equal(result.value?.kind, 'worker-launch-result');
    assert.equal(result.value?.reply_to, id);
    assert.deepEqual(result.value?.payload, { status: 'failure', code });
  }
  launcher.close();
  audit('worker-launch-closed');
  const standards = registrationContext;
  const spec = { ...standards, invocationId: 'spec', role: 'spec' as const };
  const read = { name: 'read' as const, operation: 'capture' as const, path: '/workspace/file', callId: 'read-one' };
  const first = await sandbox.executeTool(standards, read);
  assert.equal(first.status, 'success', `same Sandbox/context must rediscover the now-ready same-boot owner: ${JSON.stringify(first)}`);
  audit('discovery-recovered');
  assert.equal((await sandbox.executeTool(spec, { ...read, callId: 'read-two' })).status, 'success');
  assert.deepEqual(await sandbox.executeTool({ ...standards, phaseId: 'stale' }, read), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
  assert.deepEqual(await sandbox.executeTool({ ...standards, invocationId: 'old-boot', bootRef: 'boot-77777777-2222-4333-8444-555555555555' }, read),
    { status: 'failure', code: 'TOOL_CHANNEL_UNAVAILABLE' });
  if (first.status === 'success') assert.deepEqual(await sandbox.executeTool(spec,
    { name: 'read', operation: 'page', reference: first.reference, offset: 0, callId: 'foreign' }),
  { status: 'failure', code: 'READ_REFERENCE_DENIED' });
  const endpoint = (await readdir(runtime)).find(name => name === 'b1');
  assert.ok(endpoint);
  const worker = await connect(join(runtime, endpoint), 'local-operator');
  const replies = worker.messages[Symbol.asyncIterator]();
  await worker.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: 'forged', reply_to: null,
    kind: 'execute-tool', payload: { context: spec, call: { ...read, callId: 'forged' } } });
  assert.equal((await replies.next()).value?.payload.code, 'STALE_TOOL_CONTEXT');
  await worker.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: 'admin', reply_to: null,
    kind: 'register-binding', payload: { role: 'host-boot', context: spec } });
  const reply = await replies.next();
  assert.equal(reply.done, false);
  assert.equal(reply.value?.payload.code, 'INVALID_TOOL_CALL');
  await worker.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: 'worker-launch-admin', reply_to: null,
    kind: 'launch-worker', payload: binding });
  assert.equal((await replies.next()).value?.payload.code, 'INVALID_TOOL_CALL');
  worker.close();
  // Registration is a host-only endpoint association, not a role asserted in payload.
  const host = await connect(join(runtime, 'owner'), 'local-operator');
  await host.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: 'old-boot', reply_to: null,
    kind: 'register-binding', payload: { context: { ...standards, invocationId: 'forged-boot', bootRef: 'old-boot' } } });
  assert.equal((await host.messages[Symbol.asyncIterator]().next()).value?.payload.code, 'STALE_TOOL_CONTEXT');
  host.close();
  const afterEof = await sandbox.executeTool(standards, { ...read, callId: 'after-standards-eof' });
  assert.equal(afterEof.status, 'failure');
  if (afterEof.status === 'failure') assert.ok(['STALE_TOOL_CONTEXT', 'TOOL_CHANNEL_CLOSED'].includes(afterEof.code));
  assert.equal((await sandbox.executeTool(spec, { ...read, callId: 'after-eof' })).status, 'success');
  audit('registration-isolated');
}

// Preload runs before the actual adapter entrypoint: metadata is valid, but
// this boot's owner socket does not exist yet. Keep this exact client/context.
const registrationSandbox = mode === 'owner-registration'
  ? (await import('../../src/sandbox/index.js')).createSandbox({ root }) : undefined;
const registrationContext = { workId, executionId: 'execution', invocationId: 'standards', role: 'standards' as const,
  environmentRef: environment, bootRef: boot, phaseId: 'review' };
// Baseline after the fixture's explicit mocks; SDK constructors/operations must
// not change these references either. A standalone graph-only child needs none.
if (actualVfs && process.argv[1]?.endsWith('/src/entrypoints/adapter.js')) operationsObserver = observeSdkGlobals();
if (registrationSandbox) {
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')), { version: 1, environment, boot });
  assert.equal(fs.existsSync(join(runtime, 'owner')), false);
  const call = { name: 'read' as const, operation: 'capture' as const, path: '/workspace/file', callId: 'before-ready' };
  assert.deepEqual(await registrationSandbox.executeTool(registrationContext, call),
    { status: 'failure', code: 'TOOL_CHANNEL_UNAVAILABLE' });
  assert.deepEqual(await registrationSandbox.executeTool({ ...registrationContext, phaseId: 'changed' }, call),
    { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
  assert.equal(execCalls, 0, 'failed setup must not execute or replay a guest tool');
  audit('discovery-unavailable');
}
