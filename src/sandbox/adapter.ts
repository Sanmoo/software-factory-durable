import { readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inspectGuestAssets } from './guest-assets.js';
import { currentSchema, identitySchema, metadata, ownedEnvironment, privateDirectory, processStartTicks,
  supervisionHierarchy, unitState, type BootRef } from './lifecycle.js';
import { bootRuntimePaths, durableJson } from './start.js';
import type { EnvironmentRef } from './prepare.js';

/** One systemd main process owns exactly one VM. Never invoked by a worker. */
export async function runSandboxAdapter(root: string, environment: EnvironmentRef, boot: BootRef): Promise<void> {
  const { directory, owner } = await ownedEnvironment(root, environment);
  const path = join(directory, boot);
  // Boot input is checked before it is used to open any boot-relative file.
  if (!/^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)) throw new Error('INVALID_BOOT');
  await privateDirectory(path);
  const identity = await metadata(join(path, 'identity.json'), identitySchema);
  const unit = `factory-sandbox-${boot}.service`;
  const uid = process.getuid?.();
  const cgroup = `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`;
  const hostBoot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const state = await unitState(unit);
  if (identity.boot !== boot || identity.environment !== environment || identity.unit !== unit || identity.hostBoot !== hostBoot ||
      state.MainPID !== String(process.pid) || state.ControlGroup !== cgroup || !/^[a-f0-9]{32}$/.test(state.InvocationID ?? '') ||
      (await readFile('/proc/self/cgroup', 'utf8')).trim() !== `0::${cgroup}`) throw new Error('ADAPTER_SUPERVISION_MISMATCH');
  const namespaces = { cgroupNamespace: await readlink('/proc/self/ns/cgroup'), mountNamespace: await readlink('/proc/self/ns/mnt') };
  await supervisionHierarchy(namespaces);
  await durableJson(join(path, 'started.json'), { version: 1, boot, unit, invocation: state.InvocationID, cgroup, ...namespaces });
  const runtime = bootRuntimePaths(await realpath(root), boot);
  for (const path of [dirname(runtime.directory), runtime.directory, runtime.temporary, runtime.cache, runtime.sessions]) {
    await privateDirectory(path);
  }
  const runtimeOwner = await metadata(join(runtime.directory, 'owner.json'), currentSchema);
  if (runtimeOwner.environment !== environment || runtimeOwner.boot !== boot ||
      process.env.TMPDIR !== runtime.temporary || process.env.XDG_CACHE_HOME !== runtime.cache ||
      process.env.GONDOLIN_SESSIONS_DIR !== runtime.sessions) throw new Error('ADAPTER_RUNTIME_MISMATCH');
  if ((await inspectGuestAssets(owner.guestAssets)).some(check => check.status !== 'ok')) throw new Error('GUEST_ASSETS_INVALID');
  // No SDK import/VM construction until the manager and ownership checks above succeed.
  const { VM, RealFSProvider } = await import('@earendil-works/gondolin');
  let vm: InstanceType<typeof VM> | undefined;
  let shutdown: Promise<void> | undefined;
  let stopping = false;
  let finished!: () => void;
  const stopped = new Promise<void>(resolve => { finished = resolve; });
  const booting = (async () => {
    vm = await VM.create({ autoStart: false, memory: `${identity.configuration.memoryMiB}M`, cpus: identity.configuration.vcpus,
      tmpfs: {}, startTimeoutMs: 30000, sessionLabel: boot, debugLog: null,
      sandbox: { vmm: 'qemu', qemuPath: '/usr/bin/qemu-system-x86_64', accel: 'kvm', cpu: 'host',
        imagePath: owner.guestAssets.directory, rootDiskPath: join(directory, 'root.qcow2'), rootDiskFormat: 'qcow2',
        rootDiskReadOnly: false, rootDiskDeleteOnClose: false, netEnabled: false, autoRestart: false, console: 'none', debug: false,
        ...runtime.sockets },
      vfs: { mounts: { '/workspace': new RealFSProvider(join(directory, 'workspace')),
        '/artifacts': new RealFSProvider(join(directory, 'artifacts')) } } });
    await vm.start();
    // The pinned image must provide Alpine and its own Docker daemon with vfs.
    // Networking remains disabled in this first-boot slice; no pulls or remote calls.
    const ready = await vm.exec(['/bin/sh', '-c',
      'set -eu; test -s /etc/alpine-release; test "$(docker info --format \'{{.Driver}}\')" = vfs; sync'],
    { signal: AbortSignal.timeout(10000) });
    if (ready.exitCode !== 0) throw new Error('GUEST_PROFILE_NOT_OPERATIONAL');
    if (stopping) return;
    const pid = vm.getHostPid();
    if (!pid) throw new Error('VMM_IDENTITY_UNAVAILABLE');
    const ticks = processStartTicks(await readFile(`/proc/${pid}/stat`, 'utf8'));
    if ((await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim() !== `0::${cgroup}` ||
        processStartTicks(await readFile(`/proc/${pid}/stat`, 'utf8')) !== ticks) throw new Error('VMM_SUPERVISION_MISMATCH');
    await durableJson(join(path, 'operational.json'), { version: 1, boot, session: vm.id, vmmPid: pid, vmmStartTicks: ticks });
  })();
  const terminate = () => {
    stopping = true;
    shutdown ??= (async () => {
      try {
        await booting;
        if (vm) {
          const result = await vm.exec(['/bin/sh', '-c',
            'set -eu; docker ps -q | xargs -r docker stop; rc-service docker stop; sync'],
          { signal: AbortSignal.timeout(identity.configuration.shutdownGraceSeconds * 1000) });
          if (result.exitCode === 0) await durableJson(join(path, 'guest-synced.json'), { version: 1, boot });
        }
      } catch { /* No claim of graceful shutdown after a failed guest finalization. */ }
      finally {
        try { await vm?.close(); } finally { finished(); }
      }
    })();
    void shutdown.catch(() => { process.exitCode = 1; });
  };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  try { await booting; await stopped; await shutdown; }
  catch {
    // Systemd retains responsibility for any surviving group members, not SDK.close alone.
    await vm?.close();
    throw new Error('ADAPTER_BOOT_FAILED');
  } finally { process.off('SIGTERM', terminate); process.off('SIGINT', terminate); }
}
