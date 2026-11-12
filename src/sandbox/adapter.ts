import type { VM as GondolinVM } from '@earendil-works/gondolin';
import { readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inspectGuestAssets } from './guest-assets.js';
import { createBootMarkers } from './boot-markers.js';
import { currentSchema, identitySchema, metadata, ownedEnvironment, privateDirectory, processStartTicks,
  startupFailureCodeSchema, supervisionHierarchy, unitState, type BootRef, type StartupFailure } from './lifecycle.js';
import { bootRuntimePaths, durableJson } from './start.js';
import type { EnvironmentRef } from './prepare.js';

function startupCode(error: unknown): StartupFailure['code'] {
  if (!(error instanceof Error)) return 'UNCLASSIFIED_STARTUP_FAILURE';
  if ('code' in error && error.code === 'vm_start_timeout') return 'GUEST_READINESS_TIMEOUT';
  const systemCode = startupFailureCodeSchema.safeParse('code' in error ? error.code : undefined);
  if (systemCode.success) return systemCode.data;
  const known = startupFailureCodeSchema.safeParse(error.message === 'sandbox is stopped' ? 'SDK_START_DISABLED' : error.message);
  return known.success ? known.data : 'UNCLASSIFIED_STARTUP_FAILURE';
}

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
  let phase: StartupFailure['phase'] = 'runtime';
  let operational = false;
  let vm: GondolinVM | undefined;
  const markers = createBootMarkers(boot);
  let markerPublication: Promise<void> | undefined;
  const publishMarkers = () => {
    const snapshot = markers.seal();
    try { vm?.setDebugLog(null); } catch { /* Never let optional diagnostics skip owned close. */ }
    markerPublication ??= durableJson(join(path, 'boot-markers.json'), snapshot).catch(() => {});
    return markerPublication;
  };
  let shutdown: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const closeVm = () => closing ??= Promise.resolve().then(() => vm?.close());
  let stopping = false;
  let finished!: () => void;
  const stopped = new Promise<void>(resolve => { finished = resolve; });
  const booting = (async () => {
    const runtime = bootRuntimePaths(await realpath(root), boot);
    for (const path of [dirname(runtime.directory), runtime.directory, runtime.temporary, runtime.cache, runtime.sessions]) {
      await privateDirectory(path);
    }
    const runtimeOwner = await metadata(join(runtime.directory, 'owner.json'), currentSchema);
    if (runtimeOwner.environment !== environment || runtimeOwner.boot !== boot ||
        process.env.TMPDIR !== runtime.temporary || process.env.XDG_CACHE_HOME !== runtime.cache ||
        process.env.GONDOLIN_SESSIONS_DIR !== runtime.sessions) throw new Error('ADAPTER_RUNTIME_MISMATCH');
    phase = 'assets';
    if ((await inspectGuestAssets(owner.guestAssets)).some(check => check.status !== 'ok')) throw new Error('GUEST_ASSETS_INVALID');
    phase = 'sdk-import';
    // Runtime SDK import stays after all ownership/supervision/runtime/asset gates.
    const { VM, RealFSProvider } = await import('@earendil-works/gondolin');
    phase = 'vm-create';
    // SDK 0.14 also consults autoStart inside explicit start(); false rejects a
    // stopped VM before sending boot. Ownership is established above, not by this flag.
    vm = await VM.create({ autoStart: true, memory: `${identity.configuration.memoryMiB}M`, cpus: identity.configuration.vcpus,
      // Diagnostic VM allowance is consumed. Do not bind guest console/protocol
      // logging for operational callers: SDK serial buffering is not bounded by
      // our old marker callback. No worker flag can reactivate that diagnostic.
      tmpfs: {}, startTimeoutMs: 30000, sessionLabel: boot, debugLog: null,
      sandbox: { vmm: 'qemu', qemuPath: '/usr/bin/qemu-system-x86_64', accel: 'kvm', cpu: 'host',
        imagePath: owner.guestAssets.directory, rootDiskPath: join(directory, 'root.qcow2'), rootDiskFormat: 'qcow2',
        rootDiskReadOnly: false, rootDiskDeleteOnClose: false, netEnabled: false, autoRestart: false,
        console: 'none', debug: false,
        ...runtime.sockets },
      vfs: { mounts: { '/workspace': new RealFSProvider(join(directory, 'workspace')),
        '/artifacts': new RealFSProvider(join(directory, 'artifacts')) } } });
    phase = 'vm-start';
    await vm.start();
    // Freeze before any guest command; queued/late callbacks cannot add content.
    await publishMarkers();
    phase = 'guest-profile';
    // The pinned image must provide Alpine and its own Docker daemon with vfs.
    // Networking remains disabled in this first-boot slice; no pulls or remote calls.
    const ready = await vm.exec(['/bin/sh', '-c',
      'set -eu; test -s /etc/alpine-release; test "$(docker info --format \'{{.Driver}}\')" = vfs; sync'],
    { signal: AbortSignal.timeout(10000), stdout: 'ignore', stderr: 'ignore' });
    if (ready.exitCode !== 0) throw new Error('GUEST_PROFILE_NOT_OPERATIONAL');
    if (stopping) return;
    phase = 'operational-evidence';
    const pid = vm.getHostPid();
    if (!pid) throw new Error('VMM_IDENTITY_UNAVAILABLE');
    const ticks = processStartTicks(await readFile(`/proc/${pid}/stat`, 'utf8'));
    if ((await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim() !== `0::${cgroup}` ||
        processStartTicks(await readFile(`/proc/${pid}/stat`, 'utf8')) !== ticks) throw new Error('VMM_SUPERVISION_MISMATCH');
    await durableJson(join(path, 'operational.json'), { version: 1, boot, session: vm.id, vmmPid: pid, vmmStartTicks: ticks });
    operational = true;
  })().catch(async error => {
    // Shared startup rejection orders the bounded publication attempt before both
    // normal close and a concurrent stop; failed writes do not suppress closure.
    await publishMarkers();
    if (!operational) {
      try { await durableJson(join(path, 'failure.json'), { version: 1, boot, phase, code: startupCode(error) }); }
      catch { /* Diagnostic failure must not skip owned-resource shutdown or invent evidence. */ }
    }
    // Both normal failure handling and a concurrent stop await this publication
    // attempt before either requests close. SDK/manager cleanup remains independent.
    throw error;
  });
  const terminate = () => {
    stopping = true;
    shutdown ??= (async () => {
      try {
        await booting;
        if (vm) {
          const result = await vm.exec(['/bin/sh', '-c',
            // Guest-only, never executed on the host. This profile starts dockerd
            // directly; no OpenRC service exists. Do not mask docker-ps failures in
            // a pipeline, expand guest output as options/globs, or signal PID0/1.
            `set -efu
pid=$(cat /run/docker.pid)
case "$pid" in ''|*[!0-9]*) exit 1;; esac
test "$pid" -gt 1
test "$(readlink /proc/"$pid"/exe)" = /usr/bin/dockerd
snapshot() {
  IFS= read -r info < "/proc/$pid/stat" || return 1
  case "$info" in "$pid ("*") "*) ;; *) return 1;; esac
  fields=\${info##*) }
  set -- $fields
  test "$#" -ge 20 || return 1
  state=$1
  shift 19
  ticks=$1
  case "$ticks" in ''|*[!0-9]*) return 1;; esac
}
snapshot
original=$ticks
ids=$(docker ps -q)
for id in $ids; do
  case "$id" in *[!0-9a-f]*) exit 1;; esac
  docker stop "$id" >/dev/null
done
snapshot
test "$ticks" = "$original"
test "$(readlink /proc/"$pid"/exe)" = /usr/bin/dockerd
kill -TERM "$pid"
while test -d "/proc/$pid"; do
  if ! snapshot; then
    test -r /proc/self/stat
    test ! -d "/proc/$pid"
    break
  fi
  # A reused PID is not the daemon; a zombie has already exited. PID existence
  # alone would wait forever when sandboxd has not reaped its inherited child.
  test "$ticks" = "$original" || break
  case "$state" in Z|X) break;; esac
  sleep 0.1
done
sync`],
          // Leave part of the manager's stop grace for evidence publication and
          // SDK close. Expiration means unavailable, never successful finalization.
          { signal: AbortSignal.timeout(Math.max(1, Math.floor(identity.configuration.shutdownGraceSeconds * 800))),
            stdout: 'ignore', stderr: 'ignore' });
          if (result.exitCode === 0) await durableJson(join(path, 'guest-synced.json'), { version: 1, boot });
        }
      } catch { /* No claim of graceful shutdown after a failed guest finalization. */ }
      finally {
        try { await closeVm(); } finally { finished(); }
      }
    })();
    void shutdown.catch(() => { process.exitCode = 1; });
  };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  try { await booting; await stopped; await shutdown; }
  catch {
    // Systemd retains responsibility for any surviving group members, not SDK.close alone.
    await closeVm();
    throw new Error('ADAPTER_BOOT_FAILED');
  } finally { process.off('SIGTERM', terminate); process.off('SIGINT', terminate); }
}
